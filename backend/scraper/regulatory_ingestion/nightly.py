"""
The nightly pass, in one place — what the company-brain-watcher.timer runs.

  1. watcher.run     — re-check tracked government documents for silent edits
  2. discovery.run   — notice new regulations on regulator listing pages,
                       and probe whether India Code has come back up

Each half prints one JSON line to the journal, and a failure in one half must
not silence the other.
"""
from __future__ import annotations

import json

from . import discovery, watcher
from .db import connect


def main() -> None:
    con = connect()
    try:
        w = watcher.run(con, limit=60)
        print(json.dumps({"watcher": {k: w[k] for k in ("checked", "outcomes", "at")}}))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"watcher": f"FAILED: {type(e).__name__}: {e}"}))
    try:
        print(json.dumps({"discovery": discovery.run(con)}))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"discovery": f"FAILED: {type(e).__name__}: {e}"}))
    try:
        from . import enforcement
        print(json.dumps({"enforcement": enforcement.refresh(con)}))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"enforcement": f"FAILED: {type(e).__name__}: {e}"}))
    try:
        print(json.dumps({"auto_analysis": auto_analyse_changed(con, cap=5)}))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"auto_analysis": f"FAILED: {type(e).__name__}: {e}"}))
    try:
        from . import notifications
        print(json.dumps({"notifications": notifications.generate(con)}))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"notifications": f"FAILED: {type(e).__name__}: {e}"}))


STATE = __import__("pathlib").Path(__file__).parent.parent / "output" / "nightly.state.json"


def auto_analyse_changed(con, cap: int = 5) -> dict:
    """
    The pitch's full sentence, unattended: a regulation whose wording changed
    tonight gets a budgeted impact analysis before morning, and the owner
    alerts that generate() fans out afterwards carry fresh analysis behind
    them. Capped per night so a burst of diffs cannot burn the budget; every
    run persists as a Proposed-only record like any other.
    """
    try:
        last = json.loads(STATE.read_text()).get("last_auto", "1970-01-01")
    except Exception:
        last = "1970-01-01"
    rids = [r[0] for r in con.execute(
        """SELECT DISTINCT regulation_id FROM section_changes
           WHERE change_class='WORDING' AND detected_at > ?
           ORDER BY 1 LIMIT ?""", (last, cap)).fetchall()]
    ran, failed = [], []
    if rids:
        from .agent import graph as GR
        for rid in rids:
            try:
                r = GR.analyse(con, rid, persist=True)
                ran.append({"rid": rid, "status": r.get("status"), "route": r.get("route"),
                            "impacts": len(r.get("impacts") or r.get("pending") or [])})
            except Exception as e:  # noqa: BLE001
                failed.append(f"{rid}: {type(e).__name__}")
    from datetime import datetime, timezone
    STATE.parent.mkdir(exist_ok=True)
    STATE.write_text(json.dumps({"last_auto": datetime.now(timezone.utc).isoformat(timespec="seconds")}))
    return {"since": last, "analysed": ran, "failed": failed}


if __name__ == "__main__":
    main()
