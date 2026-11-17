"""Parser contract for the penalty layer — the selftest, as pytest."""
from regulatory_ingestion import penalties as P


def test_selftest_all_pass():
    passed, failed = P.selftest(verbose=False)
    assert failed == 0 and passed == len(P.CASES)


def test_amounts_indian_formats():
    assert P.amounts("₹5,00,000")[0][0] == 500000
    assert P.amounts("Rs. 1 crore")[0][0] == 10_000_000
    assert P.amounts("five lakh rupees")[0][0] == 500000
    assert P.amounts("submitted within 30 days") == []          # no currency, no amount


def test_defined_is_not_a_fine():
    assert P.classify("Sponsorship as defined by SEBI Regulations requires ₹300 crore net owned funds.") == []


def test_toc_line_rejected():
    assert P.classify("Penalties for ATM Cash-out…………………………………………………..7") == []


def test_exposure_formatting():
    assert P.fmt_inr(10_000_000) == "₹1 crore"
    assert P.fmt_inr(250_000) == "₹2.5 lakh"
    assert P.fmt_inr(9_999) == "₹9,999"
