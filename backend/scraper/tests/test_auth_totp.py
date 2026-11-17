"""TOTP is stdlib-only and must round-trip, respect the window, and reject junk."""
from regulatory_ingestion import auth as A


def test_roundtrip_and_window():
    sec = A.totp_new_secret()
    t = 1_700_000_000 - (1_700_000_000 % 30)         # step-aligned
    otp = A._hotp(sec, t // 30)
    assert A.totp_verify(sec, otp, at=t)
    assert A.totp_verify(sec, otp, at=t + 29)        # same step
    assert A.totp_verify(sec, otp, at=t + 59)        # next step, inside ±1 window
    assert not A.totp_verify(sec, otp, at=t + 90)    # two steps on — expired


def test_rejects_garbage():
    sec = A.totp_new_secret()
    assert not A.totp_verify(sec, "abc123")
    assert not A.totp_verify(sec, "12345")
    assert not A.totp_verify(sec, "")
    assert not A.totp_verify("", "123456")


def test_uri_shape():
    uri = A.totp_uri("ABC234", "a@b.c")
    assert uri.startswith("otpauth://totp/") and "secret=ABC234" in uri and "issuer=" in uri


def test_rfc_vector():
    # RFC 4226 appendix D: key "12345678901234567890", counter 0 -> 755224
    import base64
    sec = base64.b32encode(b"12345678901234567890").decode().rstrip("=")
    assert A._hotp(sec, 0) == "755224"
