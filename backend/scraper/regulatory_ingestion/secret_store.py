"""
Encryption for credentials an administrator saves through the UI.

Shared by every provider's configuration so there is exactly one place that
decides how a stored secret is protected, and one key to manage rather than one
per integration.

The key comes from CONFIG_ENCRYPTION_KEY. If that is unset a key file is
generated beside the project so development works out of the box — but a key
sitting next to the data it protects is not real protection, so a deployment
should set the variable and keep it somewhere the database backup cannot reach.
"""
from __future__ import annotations

import os
import pathlib

from cryptography.fernet import Fernet, InvalidToken

_KEY_FILE = pathlib.Path(__file__).parent.parent / ".config-key"


def _key() -> bytes:
    env = os.environ.get("CONFIG_ENCRYPTION_KEY", "").strip()
    if env:
        return env.encode()
    if _KEY_FILE.exists():
        return _KEY_FILE.read_bytes().strip()
    k = Fernet.generate_key()
    _KEY_FILE.write_bytes(k)
    try:
        _KEY_FILE.chmod(0o600)
    except OSError:
        pass
    return k


def encrypt(value: str) -> str:
    return Fernet(_key()).encrypt(value.encode()).decode()


def decrypt(token: str) -> str:
    """
    Plain text, or "" when it cannot be read.

    A rotated or lost key makes stored ciphertext undecryptable. Returning empty
    means the connector reports itself unconfigured and an administrator can
    re-enter the secret — better than raising from deep inside a request.
    """
    if not token:
        return ""
    try:
        return Fernet(_key()).decrypt(token.encode()).decode()
    except (InvalidToken, ValueError):
        return ""


# ---------------------------------------------------------------- shared table
# provider is the primary key, so every integration's configuration lives in one
# table with one migration path. `extra` carries whatever a given provider needs
# beyond the common shape — Microsoft's tenant and permission list, for instance
# — without a column per provider.
SCHEMA = """
CREATE TABLE IF NOT EXISTS integration_config (
  provider          TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL DEFAULT '',
  client_secret_enc TEXT,
  redirect_uri      TEXT NOT NULL DEFAULT '',
  scope             TEXT NOT NULL DEFAULT '',
  project_id        TEXT NOT NULL DEFAULT '',
  environment       TEXT NOT NULL DEFAULT 'development',
  updated_at        TEXT NOT NULL,
  updated_by        TEXT NOT NULL DEFAULT ''
);
"""

_MIGRATED = False


def init(con):
    """Create the table, and add `extra` to one that predates it."""
    global _MIGRATED
    con.executescript(SCHEMA)
    if not _MIGRATED:
        try:
            con.execute("ALTER TABLE integration_config ADD COLUMN IF NOT EXISTS extra TEXT")
        except Exception:
            # Older engines without IF NOT EXISTS: try plainly, ignore "exists".
            try:
                con.execute("ALTER TABLE integration_config ADD COLUMN extra TEXT")
            except Exception:
                pass
        _MIGRATED = True
    con.commit()
    return con
