#!/bin/bash
# Validates the Google OAuth values in .env before you waste a round trip
# through Google's consent screen finding out something was pasted wrong.
cd "$(dirname "$0")"
./.venv/bin/python - <<'PY'
import pathlib, re, sys
env = {}
for line in pathlib.Path(".env").read_text().splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()

cid = env.get("GOOGLE_CLIENT_ID", "")
sec = env.get("GOOGLE_CLIENT_SECRET", "")
uri = env.get("GOOGLE_REDIRECT_URI", "")
EXPECT = "http://localhost:8787/api/integrations/oauth/google/callback"
problems, notes = [], []

if not cid:
    problems.append("GOOGLE_CLIENT_ID is empty.")
elif not cid.endswith(".apps.googleusercontent.com"):
    problems.append(f"GOOGLE_CLIENT_ID should end in .apps.googleusercontent.com — got {cid[:28]}…")

if not sec:
    problems.append("GOOGLE_CLIENT_SECRET is empty.")
elif sec.endswith(".apps.googleusercontent.com"):
    problems.append("The client ID and secret look swapped.")
elif not sec.startswith("GOCSPX-"):
    notes.append("The secret usually starts with GOCSPX-. Double-check you copied the secret, not the ID.")

if uri != EXPECT:
    problems.append(f"GOOGLE_REDIRECT_URI must be exactly:\n      {EXPECT}\n    got:\n      {uri}")

for k, v in (("GOOGLE_CLIENT_ID", cid), ("GOOGLE_CLIENT_SECRET", sec)):
    if v != v.strip() or '"' in v or "'" in v:
        problems.append(f"{k} has stray quotes or whitespace — paste the bare value.")

if problems:
    print("\n  Not ready yet:\n")
    for p in problems: print("   ✗ " + p)
    for n in notes: print("   ! " + n)
    print()
    sys.exit(1)

print("\n  ✓ Values look right.")
for n in notes: print("   ! " + n)
print(f"\n    client id : {cid[:20]}…{cid[-30:]}")
print(f"    secret    : {len(sec)} chars, starts {sec[:7]}…")
print(f"    redirect  : {uri}")
print("\n  Make sure this exact URI is registered in the Google console under")
print("  Authorised redirect URIs, then restart the API.\n")
PY
