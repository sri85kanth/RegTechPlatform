#!/usr/bin/env python3
"""
Set a user's password.

Prompts with getpass, so the password is never echoed, never lands in shell
history, and never appears in a process listing or a log. Uses the app's own
scrypt parameters, so the result is exactly what /api/auth/login expects.

    python3 reset_password.py admin@company.example
    python3 reset_password.py --list
"""
import getpass
import sys

from regulatory_ingestion import auth as A
from regulatory_ingestion.db import connect


def main() -> int:
    args = [a for a in sys.argv[1:] if a]
    con = connect()

    if not args or args[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0

    if args[0] == "--list":
        for r in con.execute("select email, name, role, active from users order by email"):
            state = "active" if r["active"] else "INACTIVE"
            print(f"  {r['email']:<32} {r['role']:<10} {state}")
        return 0

    email = args[0].strip().lower()
    row = con.execute("select id, email, role from users where lower(email) = ?",
                      (email,)).fetchone()
    if not row:
        print(f"no such user: {email}\nrun with --list to see the accounts")
        return 1

    print(f"Setting a new password for {row['email']} (role: {row['role']})")
    pw = getpass.getpass("New password: ")
    if len(pw) < 8:
        print("too short — use at least 8 characters")
        return 1
    if pw != getpass.getpass("Repeat: "):
        print("they do not match")
        return 1

    h, salt = A.hash_password(pw)
    con.execute("update users set password_hash = ?, password_salt = ? where id = ?",
                (h, salt, row["id"]))
    con.commit()

    # prove it round-trips through the same check /api/auth/login uses
    chk = con.execute("select password_hash, password_salt from users where id = ?",
                      (row["id"],)).fetchone()
    ok = A.verify_password(pw, chk["password_hash"], chk["password_salt"])
    print("updated and verified — you can sign in now" if ok
          else "WARNING: stored, but verification failed")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
