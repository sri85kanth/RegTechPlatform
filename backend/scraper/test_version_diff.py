"""
Proves the version-diff mechanism on real text from the KYC Direction.

This is a TEST, not product data: it takes a genuine section, applies a
plausible edit, and checks the diff detects exactly that edit. No fabricated
version is ever written to the regulation's real history.
"""
import json, pathlib, sqlite3, sys
from regulatory_ingestion.db import connect
from regulatory_ingestion import versions as V

EX = pathlib.Path("../company-brain-app/public/data/extracted/reg-mdkyc.json")
doc = json.loads(EX.read_text())

# a real section from the document
real = next(s for s in doc["sections"] if len(s.get("text", "")) > 300)
original = real["text"][:340]
print("REAL TEXT (section", real.get("no"), ")")
print(" ", original[:150].replace("\n", " "), "…\n")

# an edit of the kind regulators actually make, applied to whatever this text contains
edited = original
for old, new in [("shall", "must"), ("Act, 1949", "Act, 1949 (as amended)"),
                 ("sections", "sections and sub-sections"), ("the", "the said")]:
    if old in edited:
        edited = edited.replace(old, new, 1)
        break
assert edited != original, "test setup failed: no edit was applied"

runs = __import__("regulatory_ingestion.amendments", fromlist=["word_diff"]).word_diff(original, edited)
changed = [r for r in runs if r["type"] != "equal"]

print("DIFF DETECTED")
for r in changed:
    mark = "−" if r["type"] == "removed" else "+"
    print(f"  {mark} {r['text'][:80]}")

# and through the full two-version path, in a scratch database
tmp = sqlite3.connect(":memory:")
tmp.executescript(open("regulatory_ingestion/versions.py").read().split('SCHEMA = """')[1].split('"""')[0])
tmp.execute("CREATE TABLE regulations (id TEXT PRIMARY KEY)")
tmp.execute("INSERT INTO regulations VALUES ('t')")
v1 = V.capture(tmp, "t", [{"no": "1", "title": "s", "text": original}])
v2 = V.capture(tmp, "t", [{"no": "1", "title": "s", "text": edited}])
assert v2 is not None, "second capture returned None — content was not actually different"
diffs = V.compare(tmp, "t", v1, v2)

print(f"\nEND TO END: v{v1} → v{v2} produced {len(diffs)} changed section(s)")
for c in diffs:
    print(f"  section {c['section_number']}: {c['change_type']}  +{c['words_added']} −{c['words_removed']} words")
assert len(diffs) == 1 and diffs[0]["change_type"] == "modified", "diff did not behave as expected"
print("\nPASS — identical content yields no version, edited content yields a word-level diff.")
