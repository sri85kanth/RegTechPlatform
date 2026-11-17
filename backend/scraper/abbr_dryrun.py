import re
from regulatory_ingestion import rag
from regulatory_ingestion.db import connect
con = connect()
per, glob = rag._abbreviation_lexicon(con)
print(f"  lexicon: {sum(len(v) for v in per.values())} per-regulation pairs, {len(glob)} global-unambiguous")
print("  12961 CIC ->", per.get("rbi-md-12961", {}).get("CIC"), "|  13271 CIC ->", per.get("rbi-md-13271", {}).get("CIC"), "|  global CIC ->", glob.get("CIC"))
print("  global NBFC ->", glob.get("NBFC"), "|  SEBI ->", glob.get("SEBI"), "|  III/II in lexicon:", [a for a in glob if a in ("II","III","IV")])
row = con.execute("select section_text from sections where section_text like '%(SEBI)%' limit 1").fetchone()
if row:
    snip = re.sub(r"\s+", " ", row[0]); i = snip.find("(SEBI)")
    print("  real SEBI sentence:", repr(snip[max(0,i-70):i+6]))
    print("  PAT on it        :", rag._ABBR_PAT.findall(snip[max(0,i-120):i+8]))
n = changed = 0
for c in rag.regulatory_chunks(con):
    if c["source_table"] != "obligations": continue
    n += 1
    if "Abbreviations:" in c["content"]: changed += 1
    if c["source_id"] == "rbi-md-12961-obl-058#0":
        print("  gold chunk tail:", repr(c["content"][-160:]))
print(f"  obligation chunks with an appendix: {changed}/{n}")
m = 0
for c in rag.derived_chunks(con):
    if c["source_table"] == "requirements" and "Abbreviations:" in c["content"]: m += 1
print(f"  requirement chunks with an appendix: {m}")
