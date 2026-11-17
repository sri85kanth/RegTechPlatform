"""
Users, roles and sessions.

WHY THIS IS NOT OPTIONAL
------------------------
The whole product rests on "AI proposes, human approves". Until now `actor` was
a free-text string, so an approval recorded "compliance.user" — which proves
nothing. A regulator asking "who signed off on this?" needs an identity, a role
that permitted it, and a timestamp that cannot be back-filled by whoever is
typing. That is what this adds.

CRYPTO CHOICES
--------------
Passwords: scrypt from the standard library (n=2^15), per-user random salt.
No new dependency, and it is a memory-hard KDF — not a bare SHA of the password.

Sessions: HMAC-signed opaque tokens, stored server-side so they can be revoked.
A self-contained JWT cannot be revoked before expiry, and revocation matters
more here than statelessness — a compliance tool must be able to cut off access
immediately when someone leaves.

Secrets never leave: password hashes and salts are never returned by any
function that feeds an API response.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import base64
import secrets
import struct
import time
import sqlite3
from datetime import datetime, timedelta, timezone

_now = lambda: datetime.now(timezone.utc)
_iso = lambda d: d.isoformat(timespec="seconds")

# Roles are ordered: each inherits everything below it.
ROLES = ["viewer", "reviewer", "compliance_manager", "admin"]
RANK = {r: i for i, r in enumerate(ROLES)}

# An external auditor sits outside that ladder. It inherits nothing — not even
# "read" — so every endpoint refuses it by default, and it is let into exactly
# the routes that serve what the hospital chose to share with it (the impact
# cascade of the shared regulations, and the shared documents: api_auditor.py).
EXTERNAL_ROLES = ["auditor"]
ASSIGNABLE_ROLES = ROLES + EXTERNAL_ROLES
# An account that works only in other companies (workspaces.py): it signs in
# here but has no role in the home company, so every capability check fails.
NO_ACCESS = "none"
HOME_ROLES = ASSIGNABLE_ROLES + [NO_ACCESS]
AUDITOR_CAPABILITIES = {"audit"}

# What each capability requires. Kept as data so the rules are auditable in one
# place rather than scattered through endpoint decorators.
CAPABILITIES = {
    "read": "viewer",
    "audit": "viewer",                # what an auditor may see; staff from viewer up see it too
    "propose": "reviewer",            # create actions, run the engine
    "approve": "compliance_manager",  # accept/close actions, approve mappings
    "administer": "admin",            # manage users, delete data
}

SESSION_HOURS = int(os.environ.get("SESSION_HOURS", "12"))
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 15, 8, 1
# OpenSSL caps scrypt at 32 MB by default, which n=2^15,r=8 sits exactly on top
# of. Give it headroom explicitly rather than silently weakening the parameters.
SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  -- optional link to the Person record in the Company Brain, so an approver is
  -- the same identity the org chart knows
  person_id     TEXT REFERENCES company_entities(id) ON DELETE SET NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,      -- the raw token is never stored
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
"""


_READY = False


def init(con: sqlite3.Connection) -> sqlite3.Connection:
    """Once per process — a write on every call makes reads need the write lock."""
    global _READY
    if _READY:
        return con
    try:
        con.executescript(SCHEMA)
        # additive migrations — TOTP two-factor (opt-in per user, 2026-09-06)
        for col, typ in (("totp_secret", "TEXT"), ("totp_pending", "TEXT"),
                         ("totp_enabled", "INTEGER NOT NULL DEFAULT 0")):
            try:
                con.execute(f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {col} {typ}")
            except Exception:
                pass
        con.commit()
        _READY = True
    except sqlite3.OperationalError:
        pass
    return con


# ---------------------------------------------------------------- TOTP (RFC 6238, stdlib only)
def totp_new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _hotp(secret_b32: str, counter: int) -> str:
    key = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8))
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    code = (int.from_bytes(mac[off:off + 4], "big") & 0x7FFFFFFF) % 1_000_000
    return f"{code:06d}"


def totp_verify(secret_b32: str, otp: str, *, at: float | None = None, window: int = 1) -> bool:
    """Accept the current 30s step ± `window` steps; constant-time per candidate."""
    otp = (otp or "").strip().replace(" ", "")
    if not secret_b32 or not otp.isdigit() or len(otp) != 6:
        return False
    step = int((at if at is not None else time.time()) // 30)
    return any(hmac.compare_digest(_hotp(secret_b32, step + d), otp)
               for d in range(-window, window + 1))


def totp_uri(secret_b32: str, email: str) -> str:
    return (f"otpauth://totp/Company%20Brain:{email}"
            f"?secret={secret_b32}&issuer=Company%20Brain&algorithm=SHA1&digits=6&period=30")


def mfa_enroll(con, user_id: str) -> dict:
    """A fresh pending secret — becomes active only after one valid code confirms it."""
    sec = totp_new_secret()
    row = con.execute("SELECT email FROM users WHERE id=? AND active=1", (user_id,)).fetchone()
    if not row:
        raise ValueError("no such active user")
    con.execute("UPDATE users SET totp_pending=? WHERE id=?", (sec, user_id))
    con.commit()
    return {"secret": sec, "otpauthUri": totp_uri(sec, row["email"]),
            "note": "Scan or type this into an authenticator app, then confirm with a code. "
                    "Nothing is enforced until confirmed."}


def mfa_confirm(con, user_id: str, otp: str) -> dict:
    row = con.execute("SELECT totp_pending FROM users WHERE id=?", (user_id,)).fetchone()
    if not row or not row["totp_pending"]:
        raise ValueError("no enrolment in progress — call enroll first")
    if not totp_verify(row["totp_pending"], otp):
        raise PermissionError("that code did not match — check the authenticator and try again")
    con.execute("UPDATE users SET totp_secret=totp_pending, totp_pending=NULL, totp_enabled=1 WHERE id=?",
                (user_id,))
    con.commit()
    return {"mfaEnabled": True}


def mfa_disable(con, user_id: str, otp: str) -> dict:
    row = con.execute("SELECT totp_secret, totp_enabled FROM users WHERE id=?", (user_id,)).fetchone()
    if not row or not row["totp_enabled"]:
        return {"mfaEnabled": False}
    if not totp_verify(row["totp_secret"], otp):
        raise PermissionError("a current code is required to turn two-factor off")
    con.execute("UPDATE users SET totp_secret=NULL, totp_pending=NULL, totp_enabled=0 WHERE id=?", (user_id,))
    con.commit()
    return {"mfaEnabled": False}


# ---------------------------------------------------------------- passwords
def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    dk = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt),
                        n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=64,
                        maxmem=SCRYPT_MAXMEM)
    return dk.hex(), salt


def verify_password(password: str, stored_hash: str, salt: str) -> bool:
    calc, _ = hash_password(password, salt)
    return hmac.compare_digest(calc, stored_hash)   # constant time


def password_problems(password: str) -> list[str]:
    """Refuse weak passwords at creation rather than discovering them in a breach."""
    p = password or ""
    out = []
    if len(p) < 12:
        out.append("must be at least 12 characters")
    if not any(c.isalpha() for c in p):
        out.append("must contain a letter")
    if not any(c.isdigit() for c in p):
        out.append("must contain a digit")
    if p.lower() in {"password1234", "compliance1", "changeme1234"}:
        out.append("is a known-weak password")
    return out


# ---------------------------------------------------------------- users
def _public(row) -> dict:
    d = dict(row)
    d.pop("password_hash", None)
    d.pop("password_salt", None)
    # never expose the secrets themselves — only whether two-factor is on
    d["mfaEnabled"] = bool(d.pop("totp_enabled", 0))
    d.pop("totp_secret", None)
    d.pop("totp_pending", None)
    return d


def create_user(con, *, email: str, name: str, password: str, role: str = "viewer",
                person_id: str | None = None) -> dict:
    init(con)
    email = (email or "").strip().lower()
    if "@" not in email:
        raise ValueError("a valid email is required")
    if role not in HOME_ROLES:
        raise ValueError(f"role must be one of {HOME_ROLES}")
    probs = password_problems(password)
    if probs:
        raise ValueError("password " + "; ".join(probs))
    if con.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
        raise ValueError("a user with that email already exists")
    if person_id and not con.execute(
            "SELECT 1 FROM company_entities WHERE id=?", (person_id,)).fetchone():
        raise ValueError(f"person_id '{person_id}' does not exist")

    h, salt = hash_password(password)
    uid = f"usr-{secrets.token_hex(6)}"
    con.execute(
        """INSERT INTO users (id,email,name,role,password_hash,password_salt,person_id,active,created_at)
           VALUES (?,?,?,?,?,?,?,1,?)""",
        (uid, email, name.strip(), role, h, salt, person_id, _iso(_now())))
    con.commit()
    return _public(con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def list_users(con) -> list[dict]:
    init(con)
    return [_public(r) for r in con.execute("SELECT * FROM users ORDER BY created_at")]


def set_role(con, uid: str, role: str) -> dict:
    if role not in HOME_ROLES:
        raise ValueError(f"role must be one of {HOME_ROLES}")
    con.execute("UPDATE users SET role=? WHERE id=?", (role, uid))
    con.commit()
    r = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not r:
        raise ValueError("no such user")
    return _public(r)


def deactivate(con, uid: str) -> dict:
    con.execute("UPDATE users SET active=0 WHERE id=?", (uid,))
    # revoke live sessions immediately — deactivation that leaves a valid session
    # open is not deactivation
    con.execute("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
                (_iso(_now()), uid))
    con.commit()
    return {"deactivated": uid, "sessionsRevoked": True}


# ---------------------------------------------------------------- sessions
def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def login(con, email: str, password: str, otp: str | None = None) -> dict:
    init(con)
    row = con.execute("SELECT * FROM users WHERE email=?", ((email or "").strip().lower(),)).fetchone()
    # Same failure for unknown user and wrong password — distinguishing them
    # tells an attacker which emails exist.
    if not row or not row["active"] or not verify_password(password, row["password_hash"], row["password_salt"]):
        raise PermissionError("invalid email or password")

    if "totp_enabled" in row.keys() and row["totp_enabled"]:
        # password verified first, so this message leaks nothing to a guesser
        if not otp:
            raise PermissionError("one-time code required")
        if not totp_verify(row["totp_secret"], otp):
            raise PermissionError("invalid one-time code")

    token = secrets.token_urlsafe(32)
    exp = _now() + timedelta(hours=SESSION_HOURS)
    # dead sessions only ever accumulated; login is a natural, cheap purge point
    con.execute("DELETE FROM sessions WHERE expires_at < ?", (_iso(_now()),))
    con.execute(
        "INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)",
        (_token_hash(token), row["id"], _iso(_now()), _iso(exp)))
    con.execute("UPDATE users SET last_login_at=? WHERE id=?", (_iso(_now()), row["id"]))
    con.commit()
    return {"token": token, "expiresAt": _iso(exp), "user": _public(row)}


def resolve(con, token: str) -> dict | None:
    """Token -> user, or None. Expired and revoked sessions resolve to nothing."""
    if not token:
        return None
    init(con)
    s = con.execute(
        "SELECT * FROM sessions WHERE token_hash=?", (_token_hash(token),)).fetchone()
    if not s or s["revoked_at"]:
        return None
    try:
        if datetime.fromisoformat(s["expires_at"]) < _now():
            return None
    except Exception:
        return None
    u = con.execute("SELECT * FROM users WHERE id=? AND active=1", (s["user_id"],)).fetchone()
    return _public(u) if u else None


def logout(con, token: str) -> dict:
    con.execute("UPDATE sessions SET revoked_at=? WHERE token_hash=?",
                (_iso(_now()), _token_hash(token)))
    con.commit()
    return {"loggedOut": True}


def can(user: dict | None, capability: str) -> bool:
    if not user:
        return False
    need = CAPABILITIES.get(capability)
    if not need:
        return False
    role = user.get("role", "viewer")
    if role in EXTERNAL_ROLES:
        return capability in AUDITOR_CAPABILITIES
    return RANK.get(role, -1) >= RANK[need]


def is_auditor(user: dict | None) -> bool:
    return bool(user) and user.get("role") in EXTERNAL_ROLES


def status(con) -> dict:
    init(con)
    n = con.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    # A company workspace (tenantctl.py) is created with a setup code and is
    # enforced from its first request: it is on a public address before its
    # admin exists, and an open API there would be anyone's.
    setup = bool(os.environ.get("CB_SETUP_CODE"))
    return {
        "usersConfigured": n,
        "roles": HOME_ROLES,
        "capabilities": CAPABILITIES,
        "sessionHours": SESSION_HOURS,
        # Auth is enforced only once at least one user exists, so an existing
        # deployment is not locked out the moment this ships. The flag makes the
        # state explicit rather than leaving "why is nothing protected?" a mystery.
        "enforcing": n > 0 or setup,
        "firstRun": n == 0,
        "needsSetupCode": n == 0 and setup,
        "note": None if n else
                "No users yet. Create the first admin with this workspace's setup code." if setup else
                "No users yet — the API is UNAUTHENTICATED. Create the first admin "
                "via POST /api/auth/bootstrap to turn enforcement on.",
    }
