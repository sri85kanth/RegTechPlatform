"""Section grammars against excerpts of REAL documents that yielded 0 sections."""
import extract_pdf_text as X

DGFT = """
10.00 Objective
The general provisions governing the export of dual
use items are dealt with in this Chapter.

10.01 Brief Background
India is a signatory to international conventions on
disarmament and non-proliferation and related controls.

10.02 SCOMET List
Export of dual-use items, including software and
technologies, is regulated under an Authorization.
"""

TRAI = """
CORRIGENDUM
(1) at page 103, under regulation 25, sub-regulation "(4)" shall be read as "(6)". This sentence pads the block to be substantial enough.
(2) at page 108, in Schedule I, clause "4(6)(f)" shall be read as "4(6)(b)". This sentence pads the block to be substantial enough.
(3) at page 109, in Schedule I, clause "5(5)(c)" shall be read as "5(5)(b)". This sentence pads the block to be substantial enough.
"""

CERTIN = """
Subject: Directions under sub-section (6) of section 70B.
(i) All service providers shall connect to the NTP servers of NIC for synchronisation of clocks across systems.
(ii) Any service provider shall mandatorily report cyber incidents within six hours of noticing such incidents.
(iii) Service providers shall designate a point of contact to interface with CERT-In for directions and clarifications.
"""

MD = """
CHAPTER I
1. Short title
These Directions shall be called the Reserve Bank Directions, 2026 and apply as stated herein.
2. Applicability
The provisions shall apply to every non-banking financial company operating in India.
3. Definitions
In these Directions, unless the context otherwise requires, the terms carry the meanings assigned.
"""


def _fams(t):
    d = X.parse_any_structure(t)
    return d["family"], len(d["sections"])


def test_master_direction_still_wins():
    fam, n = _fams(MD)
    assert fam == "numbered" and n == 3


def test_dgft_decimal_family():
    fam, n = _fams(DGFT)
    assert fam == "decimal" and n == 3
    assert X.parse_any_structure(DGFT)["sections"][0]["no"] == "10.00"


def test_trai_paren_family():
    fam, n = _fams(TRAI)
    assert fam == "paren" and n == 3
    assert X.parse_any_structure(TRAI)["sections"][0]["no"] == "(1)"


def test_certin_items_family():
    fam, n = _fams(CERTIN)
    assert fam == "items" and n == 3
    assert X.parse_any_structure(CERTIN)["sections"][1]["no"] == "(ii)"


def test_unstructured_stays_sectionless():
    fam, n = _fams("Just a foreword with prose and no markers at all.\nMore prose follows here.")
    assert n == 0 and fam == "none"
