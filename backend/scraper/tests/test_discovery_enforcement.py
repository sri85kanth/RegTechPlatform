"""Listing parsers and the enforcement grabber, against fixture HTML."""
from regulatory_ingestion import discovery as D
from regulatory_ingestion import enforcement as E


RBI = '<a href="BS_ViewMasDirections.aspx?id=1234">Master Direction — X</a>' \
      '<a href="BS_ViewMasDirections.aspx">no id — skipped</a>'
SEBI = '<a href="/legal/regulations/jan-2026/foo-regulations-2026_1.html">Foo Regulations</a>' \
       '<a href="/legal/other/bar.html">not a regulation path</a>'
TRAI = '<a href="/sites/default/files/x.pdf">Tariff Order</a><a href="/other/y.pdf">elsewhere</a>'


def test_rbi_parser_requires_id():
    items = list(D.parse_rbi_md(RBI, "https://www.rbi.org.in/Scripts/x"))
    assert len(items) == 1 and "id=1234" in items[0][1]


def test_sebi_parser_scopes_to_legal_paths():
    items = list(D.parse_sebi(SEBI, "https://www.sebi.gov.in/x"))
    assert len(items) == 1 and items[0][1].endswith("_1.html")


def test_trai_parser_scopes_to_files():
    items = list(D.parse_trai(TRAI, "https://trai.gov.in/x"))
    assert len(items) == 1 and items[0][1].endswith("/sites/default/files/x.pdf")


def test_penalty_sentence_survives_decimal():
    t = "imposed a monetary penalty of ₹2.00 lakh (Rupees Two lakh only) on X Bank. Next sentence."
    m = E._PENALTY_SENT.search(t)
    assert "2.00 lakh" in m.group(0)


def test_anchor_extracts_penalty_titles():
    html = "<a class='link2' href=BS_PressReleaseDisplay.aspx?prid=9>RBI imposes monetary penalty on Foo Ltd</a>"
    m = E._ANCHOR.search(html)
    assert m and m.group(2) == "9" and "penalty" in m.group(3).lower()


RSS = """<rss><channel>
<item><title><![CDATA[RBI imposes monetary penalty on Foo Bank]]></title>
<link>https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=777</link></item>
<item><title>Weekly statistical supplement</title><link>https://x/y?prid=778</link></item>
</channel></rss>"""


def test_rss_parser_reads_cdata_items():
    items = list(D.parse_rss(RSS, "https://www.rbi.org.in/x"))
    assert len(items) == 2
    assert items[0][0].startswith("RBI imposes monetary penalty") and "prid=777" in items[0][1]


def test_certin_parser_takes_pdfs():
    html = '<a href="./PDF/CERT-In_Directions_70B.pdf">Directions 70B</a><a href="/other.jsp">no</a>'
    items = list(D.parse_certin(html, "https://www.cert-in.org.in/Directions70B.jsp"))
    assert len(items) == 1 and items[0][1].endswith(".pdf")
