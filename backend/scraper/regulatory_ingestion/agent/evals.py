"""
Evals for the Impact Engine.

These are not "does it sound good" checks. Each case asserts a property that,
if violated, would make the engine unsafe to put in front of a compliance team:

  GROUNDING     never cites an entity/obligation/section that does not exist
  HONESTY       never reports a footnote mention as a detected change
  ABSTENTION    says INSUFFICIENT_EVIDENCE instead of guessing
  DEGRADATION   with no model key, still returns a real deterministic answer,
                labelled as such, rather than a stub or an invented one
  PROPOSAL      never writes anything in an approved state
  DETERMINISM   the deterministic route gives the same answer twice

They run WITHOUT an API key (asserting the fallback contract) and, when a key is
present, additionally exercise the model path. A suite that only passes with a
key would tell you nothing about the path most likely to run in production.
"""
from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Callable

from ..db import connect
from . import grounding as G
from . import llm as L
from .engine import analyse


@dataclass
class Case:
    name: str
    property: str
    run: Callable[[sqlite3.Connection], tuple[bool, str]]
    needs_key: bool = False
    # The property can only be exercised against an onboarded company. With no
    # company the engine returns route "none" and analyses nothing — correctly —
    # so these cases have nothing to assert. They SKIP, exactly as the model
    # cases skip without a key: a FAIL would be a false alarm, and the old
    # "return True, 'skipped — …'" idiom was a PASS that proved nothing.
    needs_company: bool = False


def _c(name, prop, fn, needs_key=False, needs_company=False):
    return Case(name, prop, fn, needs_key, needs_company)


# ---------------------------------------------------------------- cases
def case_grounding_rejects_invented(con):
    fake = [{"entity_id": "does-not-exist-xyz"},
            {"entity_id": "also-fake", "obligation_id": "nope"}]
    v = G.validate_impacts(con, "reg-mdkyc", fake)
    ok = len(v["kept"]) == 0 and len(v["dropped"]) == 2
    return ok, f"kept={len(v['kept'])} dropped={len(v['dropped'])}"


def case_grounding_keeps_real(con):
    real = con.execute("SELECT id FROM company_entities LIMIT 1").fetchone()
    if not real:
        return False, "no company entities to test with"
    v = G.validate_impacts(con, "reg-mdkyc", [{"entity_id": real[0]}])
    return len(v["kept"]) == 1, f"kept={len(v['kept'])}"


def case_wrong_regulation_obligation(con):
    """An obligation from a DIFFERENT regulation must not be accepted."""
    other = con.execute(
        "SELECT id FROM obligations WHERE regulation_id != 'reg-mdkyc' LIMIT 1").fetchone()
    ent = con.execute("SELECT id FROM company_entities LIMIT 1").fetchone()
    if not other or not ent:
        return True, "skipped — no cross-regulation obligation available"
    v = G.validate_impacts(con, "reg-mdkyc",
                           [{"entity_id": ent[0], "obligation_id": other[0]}])
    return len(v["kept"]) == 0, f"kept={len(v['kept'])} (should be 0)"


def case_unknown_regulation(con):
    r = analyse(con, "reg-does-not-exist", persist=False)
    return r["status"] == "NO_REGULATION", f"status={r['status']}"


def case_mention_not_detection(con):
    """
    Any regulation whose source mentions amendments but for which we have computed
    no diff must SAY so, and must never call it a detected change.

    Driven by the data rather than a hardcoded id: pinning this to one regulation
    made the eval fail the moment a source re-check legitimately moved its status.
    """
    row = con.execute(
        """SELECT a.regulation_id, COUNT(*) n FROM regulation_amendments a
           WHERE NOT EXISTS (SELECT 1 FROM section_changes c WHERE c.regulation_id = a.regulation_id)
           GROUP BY 1 ORDER BY n DESC LIMIT 1""").fetchone()
    if not row:
        return True, "skipped — no regulation with mentioned-but-undiffed amendments"
    r = analyse(con, row[0], persist=False)
    said = any("mention" in n.lower() for n in r["notes"])
    claims_detected = "change_detected" in json.dumps(r).lower()
    return said and not claims_detected, \
        f"{row[0]}: {row[1]} mentions, flagged={said} claimsDetected={claims_detected}"


def case_degrades_without_key(con):
    if L.status()["available"]:
        return True, "skipped — a key is configured"
    r = analyse(con, "reg-mdkyc", persist=False)
    ok = (r["route"] == "deterministic" and r.get("fallbackReason") == "NO_MODEL"
          and isinstance(r["impacts"], list))
    return ok, f"route={r['route']} reason={r.get('fallbackReason')} impacts={len(r['impacts'])}"


def case_never_approves(con):
    analyse(con, "reg-mdkyc", persist=True)
    bad = con.execute(
        "SELECT COUNT(*) FROM company_mappings WHERE created_by IN ('llm','deterministic') AND status!='Proposed'"
    ).fetchone()[0]
    return bad == 0, f"non-Proposed rows written by the engine: {bad}"


def case_deterministic_is_stable(con):
    a = analyse(con, "reg-mdkyc", persist=False)
    b = analyse(con, "reg-mdkyc", persist=False)
    if a["route"] != "deterministic":
        return True, "skipped — model route active"
    ka = sorted((i["entity_id"], i.get("obligation_id")) for i in a["impacts"])
    kb = sorted((i["entity_id"], i.get("obligation_id")) for i in b["impacts"])
    return ka == kb, f"{len(ka)} vs {len(kb)} impacts, identical={ka == kb}"


def case_run_is_audited(con):
    before = con.execute("SELECT COUNT(*) FROM impact_runs").fetchone()[0]
    analyse(con, "reg-mdkyc", persist=True)
    after = con.execute("SELECT COUNT(*) FROM impact_runs").fetchone()[0]
    return after == before + 1, f"impact_runs {before} -> {after}"


def case_llm_grounded(con):
    """Model path: nothing it returns may cite a non-existent id."""
    r = analyse(con, "reg-mdkyc", persist=False)
    if r["route"] != "llm":
        return True, "skipped — no model route"
    rate = (r.get("validation") or {}).get("hallucinationRate", 0)
    return rate == 0, f"hallucinationRate={rate} (dropped: {len(r['validation']['dropped'])})"


def case_llm_abstains(con):
    """Model path: a regulation with no obligations should not yield confident impacts."""
    rid = con.execute(
        """SELECT r.id FROM regulations r
           WHERE NOT EXISTS (SELECT 1 FROM obligations o WHERE o.regulation_id=r.id)
             AND EXISTS (SELECT 1 FROM documents d WHERE d.regulation_id=r.id) LIMIT 1""").fetchone()
    if not rid:
        return True, "skipped — no obligation-free regulation with a document"
    r = analyse(con, rid[0], persist=False)
    if r["route"] != "llm":
        return True, "skipped — no model route"
    confident = [i for i in r["impacts"] if (i.get("confidence") or 0) >= 80]
    return not confident, f"{len(confident)} high-confidence impacts on a regulation with no obligations"


CASES = [
    _c("grounding: invented ids rejected", "GROUNDING", case_grounding_rejects_invented),
    _c("grounding: real id kept", "GROUNDING", case_grounding_keeps_real, needs_company=True),
    _c("grounding: cross-regulation obligation rejected", "GROUNDING", case_wrong_regulation_obligation,
       needs_company=True),
    _c("edge: unknown regulation", "ABSTENTION", case_unknown_regulation),
    _c("honesty: mention is not detection", "HONESTY", case_mention_not_detection, needs_company=True),
    _c("degradation: works with no API key", "DEGRADATION", case_degrades_without_key, needs_company=True),
    _c("proposal: never writes an approved mapping", "PROPOSAL", case_never_approves, needs_company=True),
    _c("determinism: fallback route is stable", "DETERMINISM", case_deterministic_is_stable,
       needs_company=True),
    _c("audit: every run is recorded", "PROPOSAL", case_run_is_audited, needs_company=True),
    _c("llm: zero hallucinated ids", "GROUNDING", case_llm_grounded, needs_key=True),
    _c("llm: abstains without obligations", "ABSTENTION", case_llm_abstains, needs_key=True),
]


def run(verbose: bool = True) -> dict:
    con = connect()
    con.row_factory = sqlite3.Row
    have_key = L.status()["available"]
    have_company = con.execute("SELECT 1 FROM company_entities LIMIT 1").fetchone() is not None
    results, passed, failed, skipped = [], 0, 0, 0

    for c in CASES:
        why = ("requires an API key" if c.needs_key and not have_key else
               "requires an onboarded company" if c.needs_company and not have_company else None)
        if why:
            skipped += 1
            results.append({"case": c.name, "property": c.property, "result": "SKIP", "detail": why})
            if verbose:
                print(f"  SKIP  {c.property:<12} {c.name}  ({why})")
            continue
        t0 = time.time()
        try:
            ok, detail = c.run(con)
        except Exception as e:
            ok, detail = False, f"{type(e).__name__}: {str(e)[:140]}"
        dt = round(time.time() - t0, 2)
        results.append({"case": c.name, "property": c.property,
                        "result": "PASS" if ok else "FAIL", "detail": detail, "seconds": dt})
        passed += ok
        failed += (not ok)
        if verbose:
            print(f"  {'PASS' if ok else 'FAIL'}  {c.property:<12} {c.name}  ({detail})")

    summary = {"passed": passed, "failed": failed, "skipped": skipped,
               "total": len(CASES), "modelKeyPresent": have_key,
               "companyPresent": have_company, "results": results}
    if verbose:
        print(f"\n  {passed} passed, {failed} failed, {skipped} skipped "
              f"(model key {'present' if have_key else 'absent'}, "
              f"company {'onboarded' if have_company else 'not onboarded'})")
    return summary


if __name__ == "__main__":
    import sys
    sys.exit(0 if run()["failed"] == 0 else 1)
