"""Write the abbreviation lexicon the indexer derives, so every expansion can be audited."""
import json
from regulatory_ingestion import rag
from regulatory_ingestion.db import connect
per, glob = rag._abbreviation_lexicon(connect())
out = {"note": ("Derived from 'Full Words (ABBR)' patterns in the regulations' own section text, "
                "initials-checked. Per-regulation meanings override global; global holds only "
                "abbreviations with a single expansion corpus-wide, so ambiguous ones like CIC "
                "never cross regulations."),
       "global": dict(sorted(glob.items())),
       "per_regulation": {r: dict(sorted(v.items())) for r, v in sorted(per.items())}}
json.dump(out, open("output/abbreviations.json", "w"), indent=1, ensure_ascii=False)
print(f"wrote output/abbreviations.json: {len(glob)} global, "
      f"{sum(len(v) for v in per.values())} per-regulation across {len(per)} regulations")
