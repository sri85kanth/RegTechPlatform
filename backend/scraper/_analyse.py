import json, sys
from regulatory_ingestion.db import connect
from regulatory_ingestion.agent import engine as E
rid = "tl-40600-1"
con = connect()
row = con.execute("select id,title,regulator_short from regulations where id=%s",(rid,)).fetchone() if hasattr(con,"execute") else None
print("REG:", row)
res = E.analyse(con, rid, persist=False, use_memory=False)
print("KEYS:", list(res.keys()) if isinstance(res,dict) else type(res))
print(json.dumps(res, indent=2, default=str)[:3500])
