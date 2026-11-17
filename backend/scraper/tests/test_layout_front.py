"""The layout front: furniture stripping and the routing decision."""
import extract_pdf_text as X


def _pages_with_header(n=6):
    return [f"SCOMET: Special Chemicals, Organisms\nPage {i} of {n}\nBody line {i} with content that stays."
            for i in range(1, n + 1)]


def test_furniture_stripped_across_pages():
    text, removed = X._strip_furniture(_pages_with_header())
    assert removed == 12                      # header + page-number line, six pages each
    assert "SCOMET" not in text and "Page 3 of" not in text
    assert "Body line 3 with content that stays." in text


def test_two_pages_left_alone():
    pages = ["Header\nbody a", "Header\nbody b"]
    text, removed = X._strip_furniture(pages)
    assert removed == 0 and "Header" in text


def test_long_lines_never_stripped():
    long = "x" * 130
    words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]
    pages = [f"{long}\ncontent {w}" for w in words]
    _, removed = X._strip_furniture(pages)
    assert removed == 0                       # a 130-char line is content, not furniture


def test_sentence_differing_by_number_is_kept():
    pages = [f"Heading X\nThe committee shall meet at least {i} times in every quarter here."
             for i in range(1, 7)]
    text, removed = X._strip_furniture(pages)
    assert removed == 6 and "committee shall meet at least 3" in text


def test_route_reason_no_grammar():
    st = {"family": "none", "sections": []}
    assert X._needs_layout(st, npages=5, chars=9000) == "no grammar matched real text"


def test_route_reason_shredded():
    st = {"family": "numbered", "sections": [{"chars": 500}]}
    r = X._needs_layout(st, npages=40, chars=50000)
    assert r and "1 sections over 40 pages" in r


def test_no_route_when_healthy():
    st = {"family": "numbered", "sections": [{"chars": 500}] * 12}
    assert X._needs_layout(st, npages=40, chars=50000) is None
    assert X._needs_layout({"family": "none", "sections": []}, npages=1, chars=900) is None
