"""
OCR fallback for PDFs that carry no text layer.

Until now `OCR_REQUIRED` was a status the pipeline could set but nothing could
clear — there was no OCR stage at all, so every scanned document stopped dead.

Shells out to poppler + tesseract rather than adding Python image dependencies:
both are already present, and this keeps the heavy lifting out of the process.

OCR output is machine-read text, NOT the official wording. Callers must record
extraction_method='ocr tesseract' and ocr_used=1 so nothing downstream can
mistake a best-effort read for the regulator's own text.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

MIN_CHARS = 400          # same bar the text-layer path uses
DPI = 300                # below ~250 tesseract accuracy drops sharply on small print


def available() -> tuple[bool, str]:
    """Is OCR usable on this machine? Returns (ok, reason)."""
    missing = [b for b in ("pdftoppm", "tesseract") if not shutil.which(b)]
    if missing:
        return False, f"missing {', '.join(missing)} (brew install poppler tesseract)"
    return True, "poppler + tesseract present"


def best_lang(preferred: str = "eng+hin") -> str:
    """
    Indian Gazette notifications are bilingual. Running English-only over a
    Devanagari column returns confident nonsense, so use hin too when the
    traineddata is installed, and fall back cleanly when it is not.
    """
    try:
        have = set(subprocess.run(["tesseract", "--list-langs"], capture_output=True,
                                  text=True, timeout=30).stdout.split())
    except Exception:
        return "eng"
    wanted = [l for l in preferred.split("+") if l in have]
    return "+".join(wanted) or "eng"


def ocr_pdf(pdf: bytes, max_pages: int = 0, lang: str | None = None) -> dict:
    """
    Rasterise then OCR. Returns {text, pages, method, ocr_used, confidence_note}.

    Raises RuntimeError when OCR is unavailable or yields nothing useful — an
    empty read must fail loudly, not return a blank document that looks ingested.
    """
    ok, why = available()
    if not ok:
        raise RuntimeError(f"OCR unavailable: {why}")
    lang = lang or best_lang()

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        (tmp / "in.pdf").write_bytes(pdf)
        cmd = ["pdftoppm", "-png", "-r", str(DPI)]
        if max_pages:
            cmd += ["-f", "1", "-l", str(max_pages)]
        cmd += [str(tmp / "in.pdf"), str(tmp / "pg")]
        subprocess.run(cmd, check=True, capture_output=True, timeout=900)

        images = sorted(tmp.glob("pg*.png"))
        if not images:
            raise RuntimeError("pdftoppm produced no pages")

        chunks = []
        for img in images:
            r = subprocess.run(["tesseract", str(img), "stdout", "-l", lang, "--psm", "1"],
                               capture_output=True, text=True, timeout=300)
            chunks.append(r.stdout)

    text = "\n".join(chunks).strip()
    if len(text) < MIN_CHARS:
        raise RuntimeError(f"OCR produced only {len(text)} chars — not a usable read")

    return {
        "text": text,
        "pages": len(images),
        "method": "ocr tesseract",
        "ocr_used": 1,
        "lang": lang,
        "confidence_note": "Machine-read from a scanned document. Not the official wording; "
                           "verify against the source PDF before relying on it.",
    }
