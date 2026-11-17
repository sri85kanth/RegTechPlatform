"""Real deterministic run of the LangGraph engine against the live database (no API key)."""
import time
from regulatory_ingestion.db import connect
from regulatory_ingestion.agent import graph as GR, engine as E
con = connect()
# a regulation that actually has proposed mappings, so the validator sees real data
rid = con.execute("""select regulation_id from impact_relationships group by 1 order by count(*) desc limit 1""").fetchone()[0]
t = time.time(); r = GR.analyse(con, rid, persist=False)
v = r.get("validation", {})
print(f"  {rid}: status={r['status']} route={r['route']} impacts={len(r['impacts'])} "
      f"dropped={len(v.get('dropped', []))} hallucinationRate={v.get('hallucinationRate')} engine={r['engine']} in {time.time()-t:.1f}s")
print("  notes:", r["notes"])
o = E.analyse(con, rid, persist=False)
same = sorted(i["entity_id"] for i in o["impacts"]) == sorted(i["entity_id"] for i in r["impacts"])
print(f"  old engine: status={o['status']} route={o['route']} impacts={len(o['impacts'])} -> identical impact set: {same}")
r2 = GR.analyse(con, rid, persist=True)
row = con.execute("select id, status, route, model, impacts, actions, hallucination_rate from impact_runs order by id desc limit 1").fetchone()
print("  persisted row:", dict(row))
print("  persisted note:", r2["persisted"])
print("  checkpoint tables:", [t[0] for t in con.execute(
    "select table_name from information_schema.tables where table_name like 'checkpoint%' order by 1").fetchall()])
